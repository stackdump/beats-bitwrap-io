#!/usr/bin/env node
//
// Browser test for ?engine=djrust: headless Chrome over raw CDP (no npm), as
// test-wave-browser.mjs.
//
//   ./beats-bitwrap-io -addr :18090 -public public -data /tmp/djrust-data &
//   # an unreleased engine: serve a local djrust/npm/build.sh output and point at it
//   scripts/serve-djrust-pkg.py ../djrust/npm/pkg 18095 &
//   node scripts/test-djrust-browser.mjs http://localhost:18090 [http://127.0.0.1:18095/]
//
// Asserts, with the flag: djrust boots in an AudioWorklet and plays the studio's project (ticks
// advance, fires name the project's own nets, the output is not silent, Tone plays no note);
// fires' audio times are near the context clock; a mixer mute silences that net; the tempo
// control reaches the engine; stop goes back to the top; unported controls are hidden while the
// tracks view, mixer mutes and scope stay; the share payload and CID are the same as without
// the flag. Without the flag the studio still plays through Tone.

import { spawn } from 'node:child_process';
import { computeCidForJsonLd, gzipToB64Url } from '../public/lib/share/codec.js';

const HOST = process.argv[2] || 'http://localhost:18090';
const PKG = process.argv[3] || process.env.DJRUST_URL || '';
const PORT = 9342;
const CHROME = process.env.CHROME || 'google-chrome';
// One self-contained share link, so both engines open the same track.
const ENVELOPE = { '@context': 'https://beats.bitwrap.io/schema/beats-share', '@type': 'BeatsShare', v: 1, genre: 'techno', seed: 42 };
const TRACK = `cid=${await computeCidForJsonLd(ENVELOPE)}&z=${await gzipToB64Url(JSON.stringify(ENVELOPE))}`;

let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
    if (!ok) failures++;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required', `--user-data-dir=/tmp/djrust-browser-profile-${process.pid}`, 'about:blank',
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
        if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
        return r.result?.result?.value;
    };
    return new Promise(res => { ws.onopen = () => res({ send, evaluate, logs, close: () => ws.close() }); });
}

async function boot(cdp, query) {
    await cdp.send('Page.navigate', { url: `${HOST}/?${query}` });
    for (let i = 0; i < 100; i++) {
        await sleep(200);
        const ok = await cdp.evaluate(`(() => { const el = document.querySelector('petri-note');
            return !!(el && el._project && Object.keys(el._project.nets||{}).length && el._currentGen?.params?.seed != null); })()`).catch(() => false);
        if (ok) break;
    }
    await sleep(2000); // generate → project-sync settles
    // Count Tone notes and the fires the page is told about, then press play.
    await cdp.evaluate(`(async () => {
        const el = document.querySelector('petri-note');
        const { toneEngine } = await import('/audio/tone-engine.js');
        window.__toneNotes = 0;
        const orig = toneEngine.playNote.bind(toneEngine);
        toneEngine.playNote = (...a) => { window.__toneNotes++; return orig(...a); };
        window.__fires = [];
        const h = el._handleWsMessage.bind(el);
        el._handleWsMessage = (m) => {
            if (m.type === 'transition-fired') window.__fires.push({ net: m.netId, t: m.transitionId, audioT: m.audioT, now: window.Tone.getContext().rawContext.currentTime });
            return h(m);
        };
        await el._ensureToneStarted();
        if (!el._playing) el._togglePlay();
    })()`);
}

const shareOf = (cdp) => cdp.evaluate(`(async () => {
    const el = document.querySelector('petri-note');
    const { computeCidForJsonLd } = await import('/lib/share/codec.js');
    const p = await el._buildSharePayload();
    return { cid: await computeCidForJsonLd(p), payload: JSON.stringify(p) };
})()`);

let cdp;
try {
    cdp = await connect(await cdpTarget());
    await cdp.send('Runtime.enable');

    // --- default engine: the share this track makes without the flag ---
    await boot(cdp, TRACK);
    await sleep(3000);
    const tone = await cdp.evaluate(`({ toneNotes: window.__toneNotes, tick: document.querySelector('petri-note')._tick })`);
    check('default engine plays through Tone', tone.toneNotes > 0 && tone.tick > 0, JSON.stringify(tone));
    const shareTone = await shareOf(cdp);

    // --- djrust ---
    await boot(cdp, `engine=djrust&${TRACK}${PKG ? '&djrust=' + encodeURIComponent(PKG) : ''}`);
    const up = await cdp.evaluate(`(async () => {
        const el = document.querySelector('petri-note');
        const t0 = performance.now();
        for (let i = 0; i < 150 && !el._dj; i++) await new Promise(r => setTimeout(r, 100));
        const dj = el._dj ? await el._dj.catch(e => ({ error: String(e) })) : null;
        return { flag: el._djrustEngine, error: el._djrustError || dj?.error || null, version: dj?.version,
                 composer: !!dj?.composer, ms: Math.round(performance.now() - t0) };
    })()`);
    check('djrust engine boots', up.flag && up.version && !up.error, JSON.stringify(up));
    if (!up.flag) throw new Error('djrust did not start: ' + up.error);
    const shareDj = await shareOf(cdp); // before any mute / tempo change
    await sleep(4000);

    const play = await cdp.evaluate(`(async () => {
        const el = document.querySelector('petri-note');
        const dj = await el._dj;
        const an = dj.ctx.createAnalyser(); an.fftSize = 2048;
        dj.node.connect(an);
        let peak = 0;
        for (let k = 0; k < 20; k++) {
            await new Promise(r => setTimeout(r, 50));
            const buf = new Float32Array(an.fftSize); an.getFloatTimeDomainData(buf);
            for (const x of buf) peak = Math.max(peak, Math.abs(x));
        }
        const nets = Object.keys(el._project.nets);
        const fired = [...new Set(window.__fires.map(f => f.net))];
        const lead = window.__fires.slice(-40).map(f => f.audioT - f.now);
        return { tick: el._tick, toneNotes: window.__toneNotes, fires: window.__fires.length, peak,
                 fired, foreign: fired.filter(n => !nets.includes(n)), load: el._djrustLoad,
                 leadMin: Math.min(...lead), leadMax: Math.max(...lead), playing: el._playing, stats: el._djrustStats };
    })()`);
    check('ticks reach the page', play.tick > 16, `tick ${play.tick}; worklet messages ${JSON.stringify(play.stats)}`);
    check('fires reach the page', play.fires > 20, `${play.fires} fires from ${play.fired.length} nets`);
    check("fires name the studio project's nets", play.foreign.length === 0, play.foreign.join(','));
    check('output is not silent', play.peak > 0.01, `peak ${play.peak.toFixed(3)}`);
    check('Tone plays no note', play.toneNotes === 0, `${play.toneNotes}`);
    check('fire audio times are near the context clock', play.leadMin > -0.25 && play.leadMax < 0.1,
        `audioT − now in [${play.leadMin?.toFixed(3)}, ${play.leadMax?.toFixed(3)}] s`);
    check('project installed', !!play.load, JSON.stringify(play.load));

    // mute: the busiest net goes quiet
    const net = play.fired.find(n => /kick/.test(n)) || play.fired[0];
    await cdp.evaluate(`(() => { const el = document.querySelector('petri-note'); el._toggleMute(${JSON.stringify(net)}); window.__fires = []; })()`);
    await sleep(2500);
    const muted = await cdp.evaluate(`(() => { const f = window.__fires; return { n: f.length, net: f.filter(x => x.net === ${JSON.stringify(net)}).length }; })()`);
    check(`mixer mute silences ${net}`, muted.n > 0 && muted.net <= 1, JSON.stringify(muted));
    await cdp.evaluate(`document.querySelector('petri-note')._toggleMute(${JSON.stringify(net)})`);

    // tempo
    await cdp.evaluate(`document.querySelector('petri-note')._setTempo(150)`);
    await sleep(1500);
    const tempo = await cdp.evaluate(`document.querySelector('petri-note')._djrustTempo`);
    check('tempo control reaches the engine', Math.abs(tempo - 150) < 0.5, `engine tempo ${tempo}`);

    // stop → top, play again
    await cdp.evaluate(`document.querySelector('petri-note')._togglePlay()`);
    await sleep(800);
    const stopped = await cdp.evaluate(`(() => { window.__fires = []; return document.querySelector('petri-note')._playing; })()`);
    await sleep(800);
    const quiet = await cdp.evaluate(`window.__fires.length`);
    await cdp.evaluate(`document.querySelector('petri-note')._togglePlay()`);
    await sleep(1500);
    const again = await cdp.evaluate(`({ tick: document.querySelector('petri-note')._tick, fires: window.__fires.length })`);
    check('stop is silent and play starts from the top', !stopped && quiet === 0 && again.fires > 0 && again.tick < 200,
        `after stop ${quiet} fires; replay tick ${again.tick}, ${again.fires} fires`);

    // instrument pick: the mixer edits el._project in place; djrust reloads it and plays on
    const inst = await cdp.evaluate(`(async () => {
        const el = document.querySelector('petri-note');
        const sel = [...el.querySelectorAll('.pn-mixer-instrument')].find(s => s.options.length > 1);
        if (!sel) return { skipped: true };
        const before = el._djrustStats.loaded || 0;
        const pick = [...sel.options].map(o => o.value).find(v => v !== sel.value);
        sel.value = pick;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 1500));
        window.__fires = [];
        await new Promise(r => setTimeout(r, 1000));
        const net = el._project.nets[sel.dataset.netId];
        return { loads: (el._djrustStats.loaded || 0) - before, pick, now: net?.track?.instrument,
                 fires: window.__fires.length, playing: el._playing };
    })()`);
    check('instrument pick reloads the engine and plays on', inst.skipped || (inst.loads >= 1 && inst.now === inst.pick && inst.fires > 0),
        JSON.stringify(inst));

    // hidden vs kept controls
    const ui = await cdp.evaluate(`(() => {
        const el = document.querySelector('petri-note');
        const shown = (s) => [...el.querySelectorAll(s)].some(n => getComputedStyle(n).display !== 'none');
        const hide = ['.pn-effects-btn', '.pn-macros-btn', '.pn-autodj-btn', '.pn-midi-btn', '.pn-device-btn',
            '.pn-feel-open', '.pn-fx-bypass', '.pn-macro-panic', '.pn-mixer-slider-group', '.pn-mixer-test', '.pn-mixer-output'];
        const keep = ['.pn-scope-btn', '.pn-arrange-btn', '.pn-stage-btn', '.pn-mixer-mute', '.pn-mixer-instrument', '.pn-genre-select'];
        return { leaked: hide.filter(shown), missing: keep.filter(s => !shown(s)) };
    })()`);
    check('unported controls are hidden', ui.leaked.length === 0, ui.leaked.join(' '));
    check('tracks view, mixer mutes and scope stay', ui.missing.length === 0, ui.missing.join(' '));

    check('share payload and CID unchanged by the engine', shareDj.cid === shareTone.cid,
        shareDj.cid === shareTone.cid ? shareDj.cid : `tone ${shareTone.cid} ${shareTone.payload}\n     djrust ${shareDj.cid} ${shareDj.payload}`);

    const errs = cdp.logs.filter(l => /EXC|\[djrust\].*(error|unavailable)|Uncaught/i.test(l));
    check('no page errors', errs.length === 0, errs.slice(0, 5).join(' | '));
    if (process.env.VERBOSE) console.log(cdp.logs.join('\n'));
    cdp.close();
} catch (e) {
    console.error('FAIL', e.message);
    failures++;
    if (process.env.VERBOSE && cdp) console.log(cdp.logs.join('\n'));
} finally {
    chrome.kill();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall djrust browser checks passed');
process.exit(failures ? 1 : 0);

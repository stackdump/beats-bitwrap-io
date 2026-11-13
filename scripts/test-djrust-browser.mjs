#!/usr/bin/env node
//
// Browser test for the studio's audio engine (djrust): headless Chrome over raw CDP (no npm).
//
//   ./beats-bitwrap-io -addr :18090 -public public -data /tmp/djrust-data &
//   # an unreleased engine: serve a local djrust/npm/build.sh output and point at it
//   scripts/serve-djrust-pkg.py ../djrust/npm/pkg 18095 &
//   node scripts/test-djrust-browser.mjs http://localhost:18090 [http://127.0.0.1:18095/]
//
// Asserts: djrust boots in an AudioWorklet and plays the studio's project (ticks advance, fires
// name the project's own nets, the output is not silent, no Tone on the page); fires' audio
// times are near the context clock; a mixer mute silences that net; the tempo control reaches
// the engine; an FX panel slider (high-pass) and the mixer's volume change what sounds; a
// Macros-panel macro (solo-drums) runs in djrust; stop goes back to the top; an instrument pick
// reloads and plays on; a Pads-panel pad latches on the bar and a held transition holds; a
// Vocoder chord pad turns the vocoder on and it speaks, also with the track pulled out; the controls with no djrust equivalent are hidden while the FX, Macros,
// Beats, Auto-DJ, MIDI and Feel panels, the tracks view, mixer and scope stay; the share CID is
// the one this track always had (Tone's, recorded before the engine swap: contract 1).
// On a plain-http page that is not a secure context the engine says why it cannot start (on the
// page, in the console, in the Pads panel) instead of failing quietly.

import { spawn } from 'node:child_process';
import { computeCidForJsonLd, gzipToB64Url } from '../public/lib/share/codec.js';

const HOST = process.argv[2] || 'http://localhost:18090';
const PKG = process.argv[3] || process.env.DJRUST_URL || '';
const PORT = 9342;
const INSECURE_HOST = 'beats-insecure.test';
const CHROME = process.env.CHROME || 'google-chrome';
// One self-contained share link, so both engines open the same track.
const ENVELOPE = { '@context': 'https://beats.bitwrap.io/schema/beats-share', '@type': 'BeatsShare', v: 1, genre: 'techno', seed: 42 };
const TRACK = `cid=${await computeCidForJsonLd(ENVELOPE)}&z=${await gzipToB64Url(JSON.stringify(ENVELOPE))}`;
// The share CID the studio built for this track while Tone was the engine (main, 2026-11-12).
const TONE_SHARE_CID = 'z4EBG9j7qQ7roSUE3vjCFtwGaLVNuUCiTc9VzxPV5jQbs8snKoZ';

let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
    if (!ok) failures++;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    // a host name that is not localhost: plain http on it is not a secure context (the LAN case)
    `--host-resolver-rules=MAP ${INSECURE_HOST} 127.0.0.1`, `--user-data-dir=/tmp/djrust-browser-profile-${process.pid}`,
    // CHROME_ARGS: extra flags, e.g. --ignore-certificate-errors-spki-list=<hash> to trust the
    // dev certificate when testing the https LAN server (CLAUDE.md, "LAN dev server over https")
    ...(process.env.CHROME_ARGS || '').split(' ').filter(Boolean), 'about:blank',
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
    const urls = new Map(), failed = [];   // requests that failed (named when the studio does not come up)
    ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
        else if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map(a => a.value ?? a.description).join(' '));
        else if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + m.params.exceptionDetails.exception?.description);
        else if (m.method === 'Network.requestWillBeSent') urls.set(m.params.requestId, m.params.request.url);
        else if (m.method === 'Network.loadingFailed' && !m.params.canceled) failed.push(`${urls.get(m.params.requestId)}: ${m.params.errorText}`);
    };
    const send = (method, params = {}) => new Promise((res) => {
        const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
    });
    const evaluate = async (expr) => {
        const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
        return r.result?.result?.value;
    };
    return new Promise(res => { ws.onopen = () => res({ send, evaluate, logs, failed, close: () => ws.close() }); });
}

async function boot(cdp, query) {
    await cdp.send('Page.navigate', { url: `${HOST}/?${query}` });
    for (let i = 0; i < 100; i++) {
        await sleep(200);
        const ok = await cdp.evaluate(`(() => { const el = document.querySelector('petri-note');
            return !!(el && el._project && Object.keys(el._project.nets||{}).length && el._currentGen?.params?.seed != null); })()`).catch(() => false);
        if (ok) break;
        if (i === 99) {
            const at = await cdp.evaluate(`({ href: location.href, title: document.title, body: (document.body?.innerText || '').slice(0, 200) })`).catch(e => String(e));
            throw new Error(`the studio did not come up at ${HOST}: ${JSON.stringify(at)}; failed requests: ${cdp.failed.slice(-8).join(' | ') || 'none'}; logs: ${cdp.logs.slice(-5).join(' | ')}`);
        }
    }
    await sleep(2000); // generate → project-sync settles
    // Count the fires the page is told about, then press play.
    await cdp.evaluate(`(async () => {
        const el = document.querySelector('petri-note');
        const { audioEngine } = await import('/audio/engine.js');
        window.__engine = audioEngine;
        window.__fires = [];
        const h = el._handleWsMessage.bind(el);
        el._handleWsMessage = (m) => {
            if (m.type === 'transition-fired') window.__fires.push({ net: m.netId, t: m.transitionId, ch: m.midi?.channel, audioT: m.audioT, now: audioEngine.now() });
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
    await cdp.send('Network.enable');
    if (HOST.startsWith('https:')) {
        // headless Chrome swaps its certificate verifier once just after start (to apply
        // --ignore-certificate-errors-spki-list), failing whatever is in flight then with
        // ERR_CERT_VERIFIER_CHANGED: let that happen on a throwaway request first
        await cdp.send('Page.navigate', { url: `${HOST}/manifest.json` });
        await sleep(1500);
    }

    await boot(cdp, `${TRACK}${PKG ? '&djrust=' + encodeURIComponent(PKG) : ''}`);
    const up = await cdp.evaluate(`(async () => {
        const el = document.querySelector('petri-note');
        const t0 = performance.now();
        for (let i = 0; i < 150 && !el._dj; i++) await new Promise(r => setTimeout(r, 100));
        const dj = el._dj ? await el._dj.catch(e => ({ error: String(e) })) : null;
        return { up: !!dj && !dj.error, error: el._djrustError || dj?.error || null, version: dj?.version,
                 composer: !!dj?.composer, tone: typeof window.Tone, ms: Math.round(performance.now() - t0) };
    })()`);
    check('djrust engine boots', up.up && up.version && !up.error, JSON.stringify(up));
    check('no Tone on the page', up.tone === 'undefined', up.tone);
    if (!up.up) throw new Error('djrust did not start: ' + up.error);
    const shareDj = await shareOf(cdp); // before any mute / tempo change
    await sleep(4000);

    const play = await cdp.evaluate(`(async () => {
        const el = document.querySelector('petri-note');
        const dj = await el._dj;
        // the master output, after the studio's volume (what the speakers get)
        const an = dj.ctx.createAnalyser(); an.fftSize = 4096; an.smoothingTimeConstant = 0;
        window.__engine.output.connect(an);
        window.__an = an;
        // peak and the energy below 200 Hz over ~1 s of the master output
        window.__measure = async () => {
            let peak = 0, low = 0, n = 0;
            const bin = (hz) => Math.round(hz / (dj.ctx.sampleRate / an.fftSize));
            for (let k = 0; k < 20; k++) {
                await new Promise(r => setTimeout(r, 50));
                const buf = new Float32Array(an.fftSize); an.getFloatTimeDomainData(buf);
                for (const x of buf) peak = Math.max(peak, Math.abs(x));
                const f = new Float32Array(an.frequencyBinCount); an.getFloatFrequencyData(f);
                for (let i = 1; i <= bin(200); i++) low += Math.pow(10, f[i] / 10);
                n++;
            }
            return { peak, low: low / n };
        };
        const { peak } = await window.__measure();
        const nets = Object.keys(el._project.nets);
        const fired = [...new Set(window.__fires.map(f => f.net))];
        const lead = window.__fires.slice(-40).map(f => f.audioT - f.now);
        return { tick: el._tick, fires: window.__fires.length, peak,
                 fired, foreign: fired.filter(n => !nets.includes(n)), load: el._djrustLoad,
                 leadMin: Math.min(...lead), leadMax: Math.max(...lead), playing: el._playing, stats: el._djrustStats };
    })()`);
    check('ticks reach the page', play.tick > 16, `tick ${play.tick}; worklet messages ${JSON.stringify(play.stats)}`);
    check('fires reach the page', play.fires > 20, `${play.fires} fires from ${play.fired.length} nets`);
    check("fires name the studio project's nets", play.foreign.length === 0, play.foreign.join(','));
    check('output is not silent', play.peak > 0.01, `peak ${play.peak.toFixed(3)}`);
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

    // FX panel: the high-pass all the way up takes the low end out of the master
    const fxLow = await cdp.evaluate(`(async () => {
        const el = document.querySelector('petri-note');
        const slider = el.querySelector('.pn-fx-slider[data-fx="hp-freq"]');
        const set = (v) => { slider.value = String(v); slider.dispatchEvent(new Event('input', { bubbles: true })); };
        const before = await window.__measure();
        set(100);
        await new Promise(r => setTimeout(r, 600));
        const after = await window.__measure();
        set(0);
        await new Promise(r => setTimeout(r, 600));
        return { before: before.low, after: after.low, errors: el._djrustErrors || [] };
    })()`);
    check('FX panel high-pass reaches the engine', fxLow.before > 0 && fxLow.after < fxLow.before * 0.1 && !fxLow.errors.length,
        `low-band energy ${fxLow.before.toExponential(2)} → ${fxLow.after.toExponential(2)} ${fxLow.errors.join(' ')}`);

    // mixer volume: every row at 0 is the voices' floor
    const vol = await cdp.evaluate(`(async () => {
        const el = document.querySelector('petri-note');
        const sels = [...el.querySelectorAll('.pn-mixer-vol')];
        const set = (v) => sels.forEach(s => { s.value = String(v); s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); });
        const before = await window.__measure();
        set(0);
        await new Promise(r => setTimeout(r, 400));
        const after = await window.__measure();
        set(80);
        await new Promise(r => setTimeout(r, 400));
        return { rows: sels.length, before: before.peak, after: after.peak };
    })()`);
    check('mixer volume reaches the engine', vol.rows > 0 && vol.after < vol.before * 0.2,
        `${vol.rows} rows, peak ${vol.before.toFixed(3)} → ${vol.after.toFixed(3)}`);

    // Macros panel: solo-drums runs in djrust (song mute on the bar): only drum channels fire
    const macro = await cdp.evaluate(`(async () => {
        const el = document.querySelector('petri-note');
        el._fireMacro('solo-drums', { duration: 4 });
        await new Promise(r => setTimeout(r, Math.ceil(el._msPerBar()) + 300)); // past the next bar
        window.__fires = [];
        await new Promise(r => setTimeout(r, 1200));
        const chans = window.__fires.map(f => f.ch);
        return { fires: chans.length, tonal: chans.filter(c => !(c >= 10 && c <= 15)).length, errors: el._djrustErrors || [] };
    })()`);
    check('Macros panel solo-drums runs in djrust', macro.fires > 0 && macro.tonal === 0 && !macro.errors.length, JSON.stringify(macro));
    await sleep(Math.ceil(4 * 60000 / 150) + 500); // let the 4 bars run out

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

    // Pads panel: djrust's effects catalogue as pads; a latched pad lands on the next bar and
    // stays until tapped again, a held transition is on while the pointer is down
    const pads = await cdp.evaluate(`(async () => {
        const el = document.querySelector('petri-note');
        const { audioEngine } = await import('/audio/engine.js');
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        const bar = Math.ceil(el._msPerBar());
        el.querySelector('.pn-pads-btn').click();
        const panel = el.querySelector('.pn-pads-panel');
        const count = panel.querySelectorAll('.pn-pad').length;
        panel.querySelector('.pn-pads-head .pn-pads-len[data-len="latch"]').click();
        const pad = panel.querySelector('.pn-pad[data-fx="build-crush"]');
        pad.click();
        const asked = pad.dataset.state || '';
        await wait(bar + 400);
        const latched = pad.dataset.state || '';
        const active = audioEngine.fxActive.map(a => a.id + (a.latched ? ':latched' : ''));
        pad.click();
        await wait(bar + 400);
        const released = pad.dataset.state || '';
        const hold = panel.querySelector('.pn-pad[data-fx="tape_stop"]');
        const opts = { bubbles: true, pointerId: 1, isPrimary: true };
        hold.dispatchEvent(new PointerEvent('pointerdown', opts));
        await wait(bar + 400);
        const held = audioEngine.fxActive.some(a => a.id === 'tape_stop');
        hold.dispatchEvent(new PointerEvent('pointerup', opts));
        await wait(bar + 400);
        const let_go = !audioEngine.fxActive.some(a => a.id === 'tape_stop');
        el.querySelector('.pn-pads-btn').click();
        return { count, asked, latched, active, released, held, let_go, errors: el._djrustErrors || [] };
    })()`);
    check('Pads panel shows djrust\'s effects catalogue', pads.count >= 30, `${pads.count} pads`);
    check('a latched pad lands on the bar and lets go on a second tap',
        pads.asked === 'pending' && pads.latched === 'latched' && pads.active.includes('build-crush:latched') && pads.released === '' && !pads.errors.length,
        JSON.stringify(pads));
    check('a held transition pad is on while held', pads.held && pads.let_go, JSON.stringify({ held: pads.held, let_go: pads.let_go }));
    await sleep(1500); // the tape stop's tail

    // Vocoder panel: the synth shaped by the track, played from a chord pad in the key
    const voc = await cdp.evaluate(`(async () => {
        const el = document.querySelector('petri-note');
        const { audioEngine } = await import('/audio/engine.js');
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        el.querySelector('.pn-vocoder-btn').click();
        const panel = el.querySelector('.pn-vocoder-panel');
        const chords = [...panel.querySelectorAll('.pn-voc-pad')].map(p => p.textContent.trim());
        const opts = { bubbles: true, pointerId: 2, isPrimary: true };
        const pad = panel.querySelector('.pn-voc-pad[data-pad="0"]');
        let vocMsgs = 0;
        const off = audioEngine.on('voc', () => vocMsgs++);
        pad.dispatchEvent(new PointerEvent('pointerdown', opts));
        await wait(900);
        const on = panel.querySelector('.pn-voc-on').checked;
        const levels = audioEngine.vocLevels;
        const only = panel.querySelector('.pn-voc-only');
        only.checked = true; only.dispatchEvent(new Event('change', { bubbles: true }));
        await wait(500);
        const alone = await window.__measure();
        const trackVol = audioEngine.trackVolume;
        pad.dispatchEvent(new PointerEvent('pointerup', opts));
        only.checked = false; only.dispatchEvent(new Event('change', { bubbles: true }));
        const box = panel.querySelector('.pn-voc-on');
        box.checked = false; box.dispatchEvent(new Event('change', { bubbles: true }));
        off();
        el.querySelector('.pn-vocoder-btn').click();
        return { chords, on, vocMsgs, levels, alonePeak: alone.peak, trackVol, restored: audioEngine.trackVolume, errors: el._djrustErrors || [] };
    })()`);
    check('Vocoder chord pads are the key\'s triads', voc.chords.length === 7, voc.chords.join(' '));
    check('a chord pad turns the vocoder on and it speaks', voc.on && voc.vocMsgs > 0 && voc.levels?.output > 0.01 && !voc.errors.length,
        JSON.stringify({ on: voc.on, msgs: voc.vocMsgs, levels: voc.levels, errors: voc.errors }));
    check('"vocoder only" keeps the vocoder sounding without the track', voc.trackVol === 0 && voc.alonePeak > 0.01 && voc.restored > 0,
        `track level ${voc.trackVol} → ${voc.restored}, peak ${voc.alonePeak?.toFixed(3)}`);

    // Vocoder auto level: a latched chord, and the vocoder's output walks to the track's loudness
    const auto = await cdp.evaluate(`(async () => {
        const el = document.querySelector('petri-note');
        const { audioEngine } = await import('/audio/engine.js');
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        el.querySelector('.pn-vocoder-btn').click();
        const panel = el.querySelector('.pn-vocoder-panel');
        const set = (sel, v) => { const b = panel.querySelector(sel); b.checked = v; b.dispatchEvent(new Event('change', { bubbles: true })); };
        set('.pn-voc-auto', true);
        set('.pn-voc-latch', true);
        const opts = { bubbles: true, pointerId: 3, isPrimary: true };
        panel.querySelector('.pn-voc-pad[data-pad="4"]').dispatchEvent(new PointerEvent('pointerdown', opts));
        const seen = [];
        const off = audioEngine.on('voc', (m) => seen.push({ out: m.levels.output, mod: m.levels.modulator, vol: m.volume }));
        await wait(6000);
        off();
        panel.querySelector('.pn-voc-pad[data-pad="4"]').dispatchEvent(new PointerEvent('pointerdown', opts));
        set('.pn-voc-latch', false);
        set('.pn-voc-on', false);
        el.querySelector('.pn-vocoder-btn').click();
        // the last 2 s: the vocoder's average output power against the track's, in dB
        const tail = seen.slice(-10);
        const pow = (k, g = 1) => tail.reduce((s, x) => s + (x[k] * g) ** 2, 0) / Math.max(1, tail.length);
        const db = 10 * Math.log10(pow('out') / pow('mod', 0.8));
        return { reports: seen.length, db, vol: seen.at(-1)?.vol, first: seen[0]?.vol, errors: el._djrustErrors || [] };
    })()`);
    check('vocoder auto level matches the track', auto.reports > 5 && Math.abs(auto.db) < 3 && !auto.errors.length,
        `output vs track ${auto.db?.toFixed(1)} dB over the last 2 s, level ${auto.first} → ${auto.vol}`);

    // hidden vs kept controls
    const ui = await cdp.evaluate(`(() => {
        const el = document.querySelector('petri-note');
        // laid out at all (a hidden ancestor hides it too)
        const shown = (s) => [...el.querySelectorAll(s)].some(n => n.getClientRects().length > 0);
        const hide = ['.pn-mixer-pan', '.pn-mixer-locut', '.pn-mixer-loreso', '.pn-mixer-reso', '.pn-mixer-test',
            '.pn-transpose', '.pn-loop-mode-select', '.pn-crop-bar-btn', '.pn-scope-model-only', '.pn-bench-open'];
        const keep = ['.pn-effects-btn', '.pn-macros-btn', '.pn-oneshots-btn', '.pn-autodj-btn', '.pn-midi-btn',
            '.pn-feel-open', '.pn-fx-bypass', '.pn-fx-reset', '.pn-macro-panic', '.pn-scope-btn', '.pn-arrange-btn',
            '.pn-stage-btn', '.pn-mixer-mute', '.pn-mixer-instrument', '.pn-mixer-vol', '.pn-mixer-cutoff',
            '.pn-mixer-decay', '.pn-genre-select', '.pn-pads-btn', '.pn-vocoder-btn'];
        return { leaked: hide.filter(shown), missing: keep.filter(s => !shown(s)) };
    })()`);
    check('controls with no djrust equivalent are hidden', ui.leaked.length === 0, ui.leaked.join(' '));
    check('the panels, tracks view, mixer and scope stay', ui.missing.length === 0, ui.missing.join(' '));

    check("share CID is the track's own (Tone's)", shareDj.cid === TONE_SHARE_CID,
        shareDj.cid === TONE_SHARE_CID ? shareDj.cid : `got ${shareDj.cid} ${shareDj.payload}`);

    const errs = cdp.logs.filter(l => /EXC|\[djrust\].*(error|unavailable)|Uncaught/i.test(l));
    check('no page errors', errs.length === 0, errs.slice(0, 5).join(' | '));

    // the feed renderer's page modes: ?render=1 records djrust's output, ?render=offline is
    // djrust's render_offline (the same bytes every time for one engine version)
    const renderMode = async (mode) => {
        await cdp.send('Page.navigate', { url: `${HOST}/?${TRACK}&render=${mode}&maxMs=3000${PKG ? '&djrust=' + encodeURIComponent(PKG) : ''}` });
        for (let i = 0; i < 150; i++) {
            await sleep(200);
            const done = await cdp.evaluate(`!!window.__renderDone`).catch(() => false);
            if (done) break;
        }
        return cdp.evaluate(`(async () => {
            const b64 = window.__renderBlob || '';
            const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
            const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(x => x.toString(16).padStart(2, '0')).join('');
            return { error: window.__renderError, info: window.__renderInfo, bytes: bytes.length, hash };
        })()`);
    };
    // a play: "dj" share (as the Android app shares a track it composed): djrust composes the
    // envelope itself with the DJ pass, on the same nets the tracks view draws, and a re-share
    // keeps it a dj share
    const DJ = { ...ENVELOPE, play: 'dj' };
    const djTrack = `cid=${await computeCidForJsonLd(DJ)}&z=${await gzipToB64Url(JSON.stringify(DJ))}`;
    await boot(cdp, `${djTrack}${PKG ? '&djrust=' + encodeURIComponent(PKG) : ''}`);
    await sleep(4000);
    const dj = await cdp.evaluate(`(async () => {
        const el = document.querySelector('petri-note');
        const nets = Object.keys(el._project?.nets || {});
        const fired = [...new Set(window.__fires.map(f => f.net))];
        const p = await el._buildSharePayload();
        return { active: !!el._djShare?.active, fires: window.__fires.length, foreign: fired.filter(n => !nets.includes(n)),
                 play: p.play || null, errors: el._djrustErrors || [] };
    })()`);
    check('a play: "dj" share plays in djrust on the studio\'s nets', dj.active && dj.fires > 10 && dj.foreign.length === 0 && !dj.errors.length,
        JSON.stringify(dj));
    check('a dj share re-shares as one', dj.play === 'dj', String(dj.play));

    const live = await renderMode('1');
    check('?render=1 records the djrust engine', !live.error && live.bytes > 5000 && live.info?.engine === 'djrust' && live.info?.engineVersion,
        `${live.bytes} bytes ${live.info?.mimeType} ${live.info?.engine}@${live.info?.engineVersion} ${live.error || ''}`);
    const off1 = await renderMode('offline'), off2 = await renderMode('offline');
    check('?render=offline is deterministic', !off1.error && off1.bytes > 100000 && off1.hash === off2.hash,
        `${off1.bytes} bytes, ${off1.info?.speedupX}× realtime, ${off1.hash.slice(0, 16)} vs ${off2.hash.slice(0, 16)} ${off1.error || ''}`);

    // not a secure context (plain http, not localhost: a LAN address): no AudioWorklet. The
    // engine says so on the page, in the console and in the Pads panel instead of failing quietly
    const insecure = new URL(HOST);
    if (insecure.protocol !== 'http:') console.log('skip insecure-context checks (HOST is not plain http)');
    else {
        insecure.hostname = INSECURE_HOST;
        const logsBefore = cdp.logs.length;
        await cdp.send('Page.navigate', { url: `${insecure.origin}/?${TRACK}${PKG ? '&djrust=' + encodeURIComponent(PKG) : ''}` });
        for (let i = 0; i < 100; i++) {
            await sleep(200);
            if (await cdp.evaluate(`!!document.querySelector('petri-note')?._project`).catch(() => false)) break;
        }
        const nosec = await cdp.evaluate(`(async () => {
            const el = document.querySelector('petri-note');
            const secure = window.isSecureContext, worklet = typeof (new AudioContext()).audioWorklet;
            el.querySelector('.pn-pads-btn')?.click();
            el._togglePlay();
            for (let i = 0; i < 50 && !el._djrustError; i++) await new Promise(r => setTimeout(r, 100));
            const banner = document.querySelector('.pn-engine-error');
            return { secure, worklet, error: el._djrustError || null,
                     banner: banner && banner.getClientRects().length ? banner.textContent : null,
                     pads: el.querySelector('.pn-pads-panel')?.textContent.trim() || '' };
        })()`);
        const logged = cdp.logs.slice(logsBefore).filter(l => /\[djrust\] the audio engine did not start: .*secure context/.test(l));
        check('an insecure page has no AudioWorklet (the case being guarded)', nosec.secure === false && nosec.worklet === 'undefined',
            `isSecureContext ${nosec.secure}, audioWorklet ${nosec.worklet}`);
        check('the engine names the missing secure context on screen', /secure context/.test(nosec.error || '') && /secure context/.test(nosec.banner || ''),
            `error ${nosec.error}; banner ${nosec.banner}`);
        check('…in the console', logged.length > 0, cdp.logs.slice(logsBefore).filter(l => /djrust/.test(l)).join(' | '));
        check('…and in the Pads panel', /secure context/.test(nosec.pads), nosec.pads);
        const crashed = cdp.logs.slice(logsBefore).filter(l => /EXC|addModule/.test(l));
        check('…without an uncaught exception', crashed.length === 0, crashed.join(' | '));
    }

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

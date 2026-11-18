// Record mode and the test hook: window.__btw. The demo video is rendered frame by frame from this:
//
//   ?record=1&cid=<CID> | &example=<name>      the program, full screen, markers and follow on, play at once
//   &clock=manual                              no audio, no wall clock: time is window.__btw.setTime(seconds)
//
//   __btw.ready            Promise: wasm up, program loaded and evaluated (manual: primed at t = 0)
//   __btw.setTime(s)       the fake clock (manual mode); beat = s x bpm / 60 from the program's tempo
//   __btw.frame([s])       one service() + marks() + paint pass at the current fake time, synchronous
//   __btw.info()           {cid, name, bpm, bars, seconds, sections}
//   __btw.reset()          evaluate again from bar 0 (the runtime only counts forward, so a rewind is a reset)
//   __btw.recorder.start() / stop()   tap the page's master gain with MediaRecorder; stop() resolves to base64 webm/opus
//
// Frames must be rendered in increasing time order: the runtime, like the follow-scroll, keeps state.

import { ManualClock, VirtualSource } from './driver.js';

/** Installed before anything loads, so a harness can wait on __btw.ready from the first moment. */
export function early(app) {
  let resolve;
  let reject;
  const ready = new Promise((a, b) => { resolve = a; reject = b; });
  ready.catch(() => {});
  const api = {
    ready,
    _resolve: resolve,
    _reject: reject,
    app,
    setTime(t) {
      if (!app.clock) throw new Error('setTime needs ?clock=manual');
      app.clock.setTime(Number(t));
    },
    frame(t) {
      if (t != null) api.setTime(t);
      const f = app.renderFrame(app.clockNow());
      return f ? { t: app.clockNow(), bar: f.status.bar, section: f.status.section || null } : null;
    },
    info() {
      const r = app.evalReport || app.report || {};
      return { cid: app.cid || r.cid || null, name: app.progName || '', bpm: r.tempo || (app.clock && app.clock.bpm) || 120, bars: r.song_bars || null, seconds: r.seconds || null, sections: r.sections || [] };
    },
    reset() {
      if (!app.clock) throw new Error('reset needs ?clock=manual');
      return startManual(app);
    },
    recorder: makeRecorder(app),
  };
  window.__btw = api;
  return api;
}

/** Called once the program is loaded: start playing the way the mode asks. */
export async function install(app) {
  const api = window.__btw;
  try {
    if (app.manual) await startManual(app);
    else if (app.record) await startReal(app);
    api._resolve(true);
  } catch (e) {
    console.error('btw: record start failed', e);
    api._reject(e);
  }
}

async function startManual(app) {
  if (!app.btw || !app.driver) throw new Error('the module is not loaded');
  const report = app.runCheckNow();
  if (!report || !report.ok) throw new Error(`the program has ${report ? report.errors : '?'} errors`);
  if (app.driver.src) app.driver.stopSound();
  app.clock = new ManualClock(report.tempo || 120);
  app.player = null;
  const res = app.driver.evaluate(app.editor.text, new VirtualSource(app.clock, 'manual'));
  if (!res.ok) throw new Error('the program was refused');
  app.afterEval(app.editor.text, report, res);
  app.clock.setTime(0);
  app.driver.tick(); // the runtime's `play` commands, echoed into the clock's flags
  app.driver.tick();
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  app.editor.measureNow();
  app.editor.scroller.scrollTop = 0;
  app.follow.reset();
  app.renderFrame(0);
}

async function startReal(app) {
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  app.editor.measureNow();
  app.ensureAudio(); // headless Chrome with --autoplay-policy=no-user-gesture-required lets this start
  await app.play('load');
}

function makeRecorder(app) {
  let rec = null;
  let chunks = [];
  let tap = null;
  return {
    start() {
      const ctx = app.ensureAudio();
      if (!ctx || !app.master) throw new Error('no audio to record');
      if (rec) return;
      tap = ctx.createMediaStreamDestination();
      app.master.connect(tap);
      chunks = [];
      const mimeType = typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : undefined;
      rec = new MediaRecorder(tap.stream, mimeType ? { mimeType } : undefined);
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.start(250);
    },
    stop() {
      return new Promise((resolve, reject) => {
        if (!rec) return reject(new Error('the recorder is not running'));
        const r = rec;
        r.onstop = async () => {
          try { app.master.disconnect(tap); } catch { /* gone */ }
          const blob = new Blob(chunks, { type: 'audio/webm' });
          rec = null;
          tap = null;
          const buf = new Uint8Array(await blob.arrayBuffer());
          let bin = '';
          for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
          resolve(btoa(bin));
        };
        r.stop();
      });
    },
  };
}

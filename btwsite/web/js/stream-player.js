// The stream source: /api/render/<cid>?format=wav, read chunk by chunk with a ReadableStream reader,
// decoded by WavStream and scheduled gaplessly on one AudioContext (each AudioBufferSourceNode starts
// exactly where the one before it ends). Its grid() is derived from the AudioContext's clock and the
// program's tempo, so BtwRun can run on it in virtual mode and the markers follow what is heard.
//
// Injected for tests: `context` (anything with currentTime, sampleRate, createBuffer, createBufferSource)
// and `fetchFn`.

import { WavStream } from './wav.js';
import { ApiError, apiErrorFrom } from './errors.js';

const PREBUFFER = 0.35; // seconds of audio to hold before the first sound
const MIN_BUFFER_FRAMES = 4096; // do not make an AudioBuffer smaller than this (about 93 ms), but at the end
const MAX_AHEAD = 24; // seconds scheduled ahead of the clock before the reader pauses (backpressure)
const START_DELAY = 0.06;

export class StreamPlayer {
  constructor({ context, destination, url, bpm = 120, fetchFn = (...a) => fetch(...a), onChange = () => {} }) {
    this.ctx = context;
    this.dest = destination || context.destination;
    this.url = url;
    this.bpm = bpm || 120;
    this.fetchFn = fetchFn;
    this.onChange = onChange;
    this.wav = new WavStream();
    this.t0 = null; // context time at which media time 0 sounds
    this.next = 0; // context time at which the next buffer starts
    this.stall = 0; // seconds the media clock lost to underruns
    this.received = 0; // seconds of audio decoded so far
    this.underruns = 0;
    this.done = false; // the body is read to its end
    this.error = null;
    this.stopped = false;
    this.sources = new Set();
    this.playing = { A: false, B: false }; // virtual-mode echo of BtwRun's play commands
    this.info = { cid: null, seconds: null, cache: null, bpm: null };
    this._pending = [];
    this._pendingFrames = 0;
    this._abort = typeof AbortController !== 'undefined' ? new AbortController() : null;
    this._lastState = '';
  }

  /** Echo BtwRun's commands into the playing flags (virtual mode: the commands themselves are discarded). */
  echo(cmds) {
    for (const c of cmds || []) if (c && c.op === 'play') this.playing[c.deck] = !!c.on;
  }

  async start() {
    const res = await this.fetchFn(this.url, { signal: this._abort ? this._abort.signal : undefined });
    if (!res.ok) {
      let body = null;
      try { body = await res.json(); } catch { /* not JSON */ }
      throw apiErrorFrom(res.status, body, res.headers.get('Retry-After'));
    }
    const h = res.headers;
    this.info = { cid: h.get('X-Btw-Cid'), seconds: Number(h.get('X-Btw-Seconds')) || null, cache: h.get('X-Btw-Cache'), bpm: Number(h.get('X-Btw-Bpm')) || null };
    if (this.info.bpm) this.bpm = this.info.bpm;
    if (!res.body || !res.body.getReader) throw new ApiError({ code: 'network', message: 'this browser cannot stream a response' });
    this._pump(res.body.getReader()).catch((e) => {
      if (this.stopped) return;
      this.error = e;
      this._emit();
    });
  }

  async _pump(reader) {
    for (;;) {
      if (this.stopped) {
        try { await reader.cancel(); } catch { /* gone */ }
        return;
      }
      // backpressure: the server renders faster than real time, no need to hold minutes of audio scheduled
      while (!this.stopped && this.t0 != null && this.next - this.ctx.currentTime > MAX_AHEAD) await new Promise((r) => setTimeout(r, 200));
      const { value, done } = await reader.read();
      if (done) break;
      const out = this.wav.push(value);
      if (out) {
        this._pending.push(out.channels);
        this._pendingFrames += out.frames;
        this.received = this.wav.seconds;
        const sr = this.wav.header.sampleRate;
        const need = this.t0 == null ? Math.max(MIN_BUFFER_FRAMES, PREBUFFER * sr) : MIN_BUFFER_FRAMES;
        if (this._pendingFrames >= need) this._flush();
      }
      this._emit();
    }
    this.done = true;
    if (this._pendingFrames) this._flush();
    this._emit();
  }

  _flush() {
    const parts = this._pending;
    const frames = this._pendingFrames;
    this._pending = [];
    this._pendingFrames = 0;
    const h = this.wav.header;
    const chs = h.channels;
    const buf = this.ctx.createBuffer(chs, frames, h.sampleRate);
    for (let c = 0; c < chs; c++) {
      const data = new Float32Array(frames);
      let off = 0;
      for (const p of parts) {
        data.set(p[c], off);
        off += p[c].length;
      }
      buf.copyToChannel(data, c);
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.dest);
    const now = this.ctx.currentTime;
    if (this.t0 == null) {
      this.t0 = now + START_DELAY;
      this.next = this.t0;
    } else if (this.next < now + 0.005) {
      // an underrun: the audio ran out before this chunk came. Start it now and take the gap off the media clock.
      const gap = now + 0.02 - this.next;
      this.stall += gap;
      this.next += gap;
      this.underruns++;
    }
    src.onended = () => {
      this.sources.delete(src);
      try { src.disconnect(); } catch { /* already */ }
    };
    src.start(this.next);
    this.sources.add(src);
    this.next += frames / h.sampleRate;
  }

  /** Seconds of the program that are sounding now (output latency taken off). */
  mediaTime() {
    if (this.t0 == null) return 0;
    const lat = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    return Math.min(Math.max(this.ctx.currentTime - lat - this.t0 - this.stall, 0), this.received);
  }

  /**
   * The clock BtwRun runs on: beat = media seconds x tempo / 60. null until the first sound and until BtwRun has
   * played a deck (virtual mode): the runtime puts the program's bar 0 on the first grid it sees with a clock, so
   * a grid before its `play` command would make every bar count one late.
   */
  grid() {
    if (this.t0 == null || !(this.playing.A || this.playing.B)) return null;
    return { deck: 'A', beat: (this.mediaTime() * this.bpm) / 60, bpm: this.bpm, playing: { ...this.playing } };
  }

  /** Seconds of audio scheduled ahead of the clock. */
  buffered() {
    return this.t0 == null ? this._pendingFrames / (this.wav.header ? this.wav.header.sampleRate : 44100) : Math.max(0, this.next - this.ctx.currentTime);
  }

  /** 'connecting' | 'buffering' | 'playing' | 'ended' | 'error' | 'stopped' */
  get state() {
    if (this.stopped) return 'stopped';
    if (this.error) return 'error';
    if (this.t0 == null) return 'connecting';
    if (this.done && this.ctx.currentTime >= this.next - 0.01) return 'ended';
    if (!this.done && this.next - this.ctx.currentTime < 0.02) return 'buffering';
    return 'playing';
  }

  _emit() {
    const s = this.state;
    if (s !== this._lastState) {
      this._lastState = s;
      this.onChange(s);
    }
  }

  stop() {
    this.stopped = true;
    if (this._abort) this._abort.abort();
    for (const s of this.sources) {
      try { s.stop(); } catch { /* not started */ }
      try { s.disconnect(); } catch { /* already */ }
    }
    this.sources.clear();
    this._emit();
  }
}

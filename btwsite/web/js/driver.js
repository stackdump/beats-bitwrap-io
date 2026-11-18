// The driver owns the BtwRun and one source of time. Two kinds of source share one interface:
//   grid()    what BtwRun.service() wants ({deck, beat, bpm, playing:{A,B}} or null)
//   handle()  what to do with the commands service()/stop() return
// - EngineSource: the in-browser engine; its commands are applied (edits land on the next bar).
// - VirtualSource: a clock the page already has (the streamed render, or record mode's fake clock); the
//   commands are discarded and `play` commands are echoed into its playing flags (virtual mode).
// tick(now) is one pass: service, then marks and status. It is the only thing the frame loop calls.

export class EngineSource {
  constructor(engine) {
    this.kind = 'engine';
    this.engine = engine;
  }
  grid() {
    return this.engine.grid();
  }
  handle(cmds) {
    if (cmds && cmds.length) this.engine.apply(cmds);
  }
  stop() {}
}

export class VirtualSource {
  /** clock: anything with grid() and echo(cmds); `kind` is what the page shows ('stream' | 'manual'). */
  constructor(clock, kind = 'stream') {
    this.kind = kind;
    this.clock = clock;
  }
  grid() {
    return this.clock.grid();
  }
  handle(cmds) {
    this.clock.echo(cmds);
  }
  stop() {
    if (this.clock.stop) this.clock.stop();
  }
}

/** A clock the page sets by hand (record mode, ?clock=manual): beat = seconds x bpm / 60. */
export class ManualClock {
  constructor(bpm = 120) {
    this.t = 0;
    this.bpm = bpm;
    this.playing = { A: false, B: false };
  }
  setTime(t) {
    this.t = t;
  }
  /** null until a deck plays: the runtime anchors bar 0 on the first grid it sees, so it must not see one before its `play`. */
  grid() {
    if (!this.playing.A && !this.playing.B) return null;
    return { deck: 'A', beat: (this.t * this.bpm) / 60, bpm: this.bpm, playing: { ...this.playing } };
  }
  echo(cmds) {
    for (const c of cmds || []) if (c && c.op === 'play') this.playing[c.deck] = !!c.on;
  }
}

export class Driver {
  constructor(btw) {
    this.btw = btw;
    this.run = null;
    this.src = null;
    this.evalText = null; // the text the running program was evaluated from (markers are in its coordinates)
    this.evalCid = null;
    this.last = null; // the last tick's {marks, status, grid}
  }

  get kind() {
    return this.src ? this.src.kind : null;
  }

  /**
   * Evaluate `text` on `src`. On the same kind of source as the running program the same BtwRun takes it
   * (a hot reload: it lands on the next bar); otherwise a fresh BtwRun starts. Returns the eval answer;
   * `ok: false` means nothing changed and the last good program plays on.
   */
  evaluate(text, src) {
    const same = this.run && this.src && src === this.src;
    const run = same ? this.run : this.btw.newRun();
    const res = run.eval(text);
    if (!res.ok) {
      if (!same) run.free();
      return res;
    }
    if (!same) {
      if (this.run) this.stopSound();
      this.run = run;
      this.src = src;
    }
    this.evalText = text;
    this.evalCid = res.cid || run.cid();
    this._st = null;
    return res;
  }

  /** One pass: service the runtime with the source's clock, hand its commands on, read what to show. */
  tick() {
    if (!this.run || !this.src) return null;
    const grid = this.src.grid();
    const cmds = this.run.service(grid);
    this.src.handle(cmds);
    const marks = this.run.marks();
    this.last = { marks, status: this.statusFor(marks), grid, evalText: this.evalText };
    return this.last;
  }

  /**
   * What status() says, kept fresh from marks() between asking. status() is expensive (it hashes every net:
   * tens of milliseconds a call on a big song) and marks() costs about 1 ms, so the runtime is asked for its
   * status when the program starts, when the section changes (the header's span moves) and every 8 bars, and in
   * between the numbers that move with the clock are carried forward from the marks: bar, phrase, song_bar,
   * section_bar, generation, ended. A pure function of the marks and what was asked last, so a rendered video
   * is the same whenever status() was called.
   */
  statusFor(marks) {
    const line = Math.max(0, Math.floor((marks.bar || 0) + 1e-9));
    const hs = marks.header && marks.header.span ? (marks.header.span.start16 ?? marks.header.span.start) : -1;
    let c = this._st;
    if (!c || c.hs !== hs || line < c.line || line - c.line >= 8 || c.running !== !!marks.running || c.ended !== !!marks.ended) {
      c = this._st = { hs, line, running: !!marks.running, ended: !!marks.ended, s: this.run.status() };
    }
    const st = { ...c.s };
    for (const k of ['words', 'controls', 'nets', 'text']) delete st[k];
    st.running = !!marks.running;
    st.ended = !!marks.ended;
    if (!marks.running) return st; // ended or stopped: marks() has no position any more, status() was just asked and stands
    const d = line - c.line;
    st.bar = line;
    st.bar_in_phrase = (line % 8) + 1;
    st.phrase = Math.floor(line / 8) + 1;
    if (st.song_bar != null) st.song_bar = c.s.song_bar + d;
    if (st.section_bar != null) st.section_bar = c.s.section_bar + d;
    if (marks.generation != null) st.generation = marks.generation;
    return st;
  }

  /** Stop the program: the runtime puts back what its lines held, then the decks stop and the clock goes. */
  stopSound() {
    if (!this.run || !this.src) return;
    try {
      this.src.handle(this.run.stop());
      this.src.handle([{ op: 'play', deck: 'A', on: false }, { op: 'play', deck: 'B', on: false }]);
    } catch { /* a stopped runtime has nothing to put back */ }
    this.src.stop();
    this.run.free();
    this.run = null;
    this.src = null;
    this.evalText = null;
    this.evalCid = null;
    this.last = null;
    this._st = null;
  }
}
